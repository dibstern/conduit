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

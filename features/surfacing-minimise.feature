Feature: Turns minimise to a head and thin strip without losing messages

Scenario Outline: Chevron and h remember a hand choice over the setting
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And minimising uses the <theme> theme with Turns open Auto
  And the minimising session has three turns
  When I minimise turn 2 by chevron
  Then turn 2 is minimised with a 4px strip
  And the messages region visually matches surfacing-minimised-<viewport>-<theme> at <threshold> percent
  When I reload the minimising session with Turns open Expanded
  Then turn 2 is minimised with a 4px strip
  When I toggle turn 2 with h
  Then turn 2 is expanded
  When I reload the minimising session with Turns open Minimised
  Then turn 2 is expanded
  And turn 1 is minimised with a 4px strip

Examples:
  | viewport | theme | threshold |
  | desktop  | dark  | 98        |
  | desktop  | light | 98        |
  | phone    | dark  | 98        |
  | phone    | light | 98        |

Scenario Outline: Hovering a minimised strip peeks and a click opens the nearest message
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a desktop
  And minimising uses the <theme> theme with Turns open Minimised
  And the minimising session has three turns
  When I hover the strip at message 1 in turn 3
  Then turn 3 peeks at message 1 with Click to open
  And the messages region visually matches surfacing-peek-desktop-<theme> at <threshold> percent
  When I click the strip at message 1 in turn 3
  Then turn 3 is expanded on message 1

Examples:
  | theme | threshold |
  | dark  | 98        |
  | light | 98        |

Scenario Outline: On a phone a tap on the minimised strip opens the nearest message
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a phone
  And minimising uses the <theme> theme with Turns open Minimised
  And the minimising session has three turns
  When I tap the strip at message 1 in turn 3
  Then turn 3 is expanded on message 1

Examples:
  | theme |
  | dark  |
  | light |

Scenario Outline: Auto folds only older fully read turns and expands explicit destinations
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And minimising uses the <theme> theme with Turns open Auto
  And the minimising session has three turns
  Then turn 1 is minimised with a 4px strip
  And turn 2 is expanded
  And turn 3 is expanded
  When message 6 in turn 1 becomes unread
  Then turn 1 is expanded
  When message 6 in turn 1 becomes read
  Then turn 1 is minimised with a 4px strip
  When I minimise turn 3 by chevron
  Then the minimised turn keeps its unread and open Ask dots
  When I open turn 3 by <destination>
  Then turn 3 is expanded on message <ordinal>

Examples:
  | viewport | theme | destination | ordinal |
  | desktop  | dark  | unread      | 1       |
  | phone    | light | u           | 1       |
  | desktop  | light | Ask         | 2       |

Scenario Outline: Turns open persists from Surfacing General
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing has a valid key in the <theme> theme
  When I open settings to Surfacing
  Then Turns open defaults to Auto and saves all three choices

Examples:
  | viewport | theme |
  | desktop  | dark  |
  | phone    | light |

Feature: Session skills chip

Scenario Outline: A phone shows the session's skills beside the identity
  Given the viewport is a phone
  And the session loaded the skills "<loads>"
  And the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 400 pixels
  Then the skills chip reads <count> skills used
  And the skills chip sits between back and the identity
  And the skills chip has a 44 pixel touch target
  And the session-bar region visually matches <baseline> at <threshold> percent

Examples:
  | loads                                                                                                  | count | baseline                | threshold |
  | release-notes by you in turn 1; changelog-style by agent in turn 1; changelog-style by agent in turn 2 | 2     | session-bar-with-skills | 98        |

Scenario Outline: The phone chip opens a sheet listing each skill once
  Given the viewport is a phone
  And the session loaded the skills "<loads>"
  And the conduit app is served with the long-transcript mockup
  When I open the skills chip
  Then the skills list opens as a sheet
  And the skills list shows "<rows>"
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | loads                                                                                                  | rows                                                                                     | baseline             | threshold |
  | release-notes by you in turn 1; changelog-style by agent in turn 1; changelog-style by agent in turn 2 | release-notes (you · turn 1 · 5m ago); changelog-style ×2 (agent · turns 1, 2 · 5m ago) | session-skills-sheet | 98        |

Scenario Outline: The desktop chip opens a popover before the identity
  Given the session loaded the skills "<loads>"
  And the conduit app is served with the long-transcript mockup
  Then the skills chip reads <count> skill used
  And the skills chip sits between the title row and the identity
  And the desktop session bar remains one row
  When I open the skills chip
  Then the skills list opens as a popover
  And the skills list shows "<rows>"
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | loads                                                            | count | rows                                                 | baseline               | threshold |
  | release-notes by you in turn 1; release-notes by agent in turn 3 | 1     | release-notes ×2 (you + agent · turns 1, 3 · 5m ago) | session-skills-popover | 98        |

Scenario: A session without skills shows no chip
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  Then there is no skills chip

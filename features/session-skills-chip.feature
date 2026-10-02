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

Scenario Outline: The chip updates and pulses while the agent loads a skill
  Given the viewport is a phone
  And the session loaded the skills "<before>"
  And the conduit app is served with the long-transcript mockup
  Then the skills chip reads 1 skill used
  When the agent starts loading a skill, leaving the session with "<during>"
  Then the skills chip reads <count> skills used
  And the skills chip pulses
  When I open the skills chip
  Then the skills list shows "<rows>"
  And the screen region visually matches <baseline> at <threshold> percent
  When the agent finishes loading the skill
  Then the skills chip does not pulse

Examples:
  | before                         | during                                                                       | count | rows                                                                         | baseline                 | threshold |
  | release-notes by you in turn 1 | release-notes by you in turn 1; changelog-style by agent in turn 2, loading | 2     | release-notes (you · turn 1 · 5m ago); changelog-style (agent · turn 2 · loading now) | session-skills-loading | 98        |

Scenario Outline: A skill typed in another tab shows up here
  Given the viewport is a phone
  And the session loaded the skills "<before>"
  And the conduit app is served with the long-transcript mockup
  Then the skills chip reads 1 skill used
  When another tab sends "<text>", leaving the session with "<after>"
  Then the skills chip reads <count> skills used

Examples:
  | before                         | text                             | after                                                            | count |
  | release-notes by you in turn 1 | /changelog-style tidy the notes | release-notes by you in turn 1; changelog-style by you in turn 2 | 2     |

Scenario: A session without skills shows no chip
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  Then there is no skills chip

Scenario: An agent skill row reveals the latest tied run across older pages
  Given the viewport is a phone
  And the session loaded skills with transcript anchors
  And the conduit app is served with the skill-navigation mockup
  Then turn 3 is absent from the first transcript page
  When I open the skills chip
  And I tap the skill row "paged-skill"
  Then two older transcript pages were requested
  And the Skill step in turn 3 is focused in its expanded activity panel and in the viewport
  And the skills toggle for turn 3 stays closed
  When I collapse the activity panel for turn 3
  And I open the skills chip
  And I tap the skill row "paged-skill"
  Then the Skill step in turn 3 is focused in its expanded activity panel and in the viewport
  And the skills toggle for turn 3 stays closed
  And two older transcript pages were requested

Scenario: A user skill row brings its prompt into view
  Given the viewport is a phone
  And the session loaded skills with transcript anchors
  And the conduit app is served with the skill-navigation mockup
  Then the user message in turn 42 is loaded outside the viewport
  When I open the skills chip
  And I tap the skill row "user-skill"
  Then the user message in turn 42 is in the viewport

Scenario: A missing skill run shows a quiet toast without moving the transcript
  Given the viewport is a phone
  And the session loaded the skills "missing-skill by agent in turn 1"
  And the conduit app is served with the long-transcript mockup
  When I leave the transcript halfway up and remember its position
  And I open the skills chip
  And I tap the skill row "missing-skill"
  Then a quiet toast says "That skill run is no longer in this session"
  And the transcript has not moved for the skill navigation

Scenario Outline: Holding a phone skill offers every run without jumping on release
  Given the viewport is a phone
  And the session loaded skills with transcript anchors
  And the conduit app is served with the skill-navigation mockup
  When I open the skills chip
  And I hold the skill row "paged-skill"
  Then the skills list opens as a sheet
  And the earlier runs for "paged-skill" show "Jump to turn 3 (agent · 5m ago); Jump to turn 1 (agent · 5m ago); Jump to turn 2 (agent · 10m ago)"
  And no older transcript pages were requested
  And the screen region visually matches <baseline> at <threshold> percent
  When I select the skill action "Jump to turn 1"
  Then two older transcript pages were requested
  And the Skill step in turn 1 is focused in its expanded activity panel and in the viewport
  And the skills toggle for turn 1 stays closed
  And the skills menu is closed

Examples:
  | baseline            | threshold |
  | session-skills-runs | 98        |

Scenario Outline: A desktop skill's document stays inside the open popover
  Given the session loaded skills with transcript anchors
  And the conduit app is served with the skill-navigation mockup
  When I open the skills chip
  And I right-click the skill row "paged-skill"
  Then the earlier runs for "paged-skill" show "Jump to turn 3 (agent · 5m ago); Jump to turn 1 (agent · 5m ago); Jump to turn 2 (agent · 10m ago)"
  When I select the skill action "Open SKILL.md"
  Then SKILL.md was requested for "paged-skill"
  And the skill document heading "Skill instructions" is visible inside the open popover
  And the screen region visually matches <baseline> at <threshold> percent
  When I select the skill action "Hide SKILL.md"
  Then the skill document is hidden
  When I select the skill action "Open SKILL.md"
  Then the skill document heading "Skill instructions" is visible inside the open popover
  When I press ArrowLeft in the skills menu
  Then the skills list shows "paged-skill ×3 (agent · turns 1, 3, 2 · 5m ago); user-skill (you · turn 42 · 5m ago)"
  And the skill row "paged-skill" is focused
  And the skill document is hidden
  When I right-click the skill row "paged-skill"
  And I select the skill action "Open SKILL.md"
  Then the skill document heading "Skill instructions" is visible inside the open popover
  When I press Escape in the skills menu
  Then the skills menu is closed
  When I open the skills chip
  Then the skills list shows "paged-skill ×3 (agent · turns 1, 3, 2 · 5m ago); user-skill (you · turn 42 · 5m ago)"
  And the skill document is hidden

Examples:
  | baseline           | threshold |
  | session-skills-doc | 98        |

Scenario Outline: Keyboard users can enter earlier runs and return to the same row
  Given the session loaded skills with transcript anchors
  And the conduit app is served with the skill-navigation mockup
  When I open the skills chip
  And I focus the skill row "paged-skill"
  And I press <key> in the skills menu
  Then the earlier runs for "paged-skill" show "Jump to turn 3 (agent · 5m ago); Jump to turn 1 (agent · 5m ago); Jump to turn 2 (agent · 10m ago)"
  And the first skill run is focused
  When I select the skill action "All skills"
  Then the skills list shows "paged-skill ×3 (agent · turns 1, 3, 2 · 5m ago); user-skill (you · turn 42 · 5m ago)"
  And the skill row "paged-skill" is focused

Examples:
  | key         |
  | ArrowRight  |
  | ContextMenu |
  | Shift+F10   |

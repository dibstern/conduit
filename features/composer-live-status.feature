Feature: Composer shows the current turn's live status

Background:
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  And I open a composer session
  And the composer status clock is frozen
  And the transcript is live
  And the transcript is pinned to the bottom

Scenario Outline: header follows the turn lifecycle and restarts its clock
  Then the composer status header is not visible
  When the mock relay starts a composer turn
  Then the composer status header is visible
  And the composer elapsed label reads Working 0:00
  When the composer status clock advances by 65 seconds
  Then the composer elapsed label reads Working 1:05
  And the composer region visually matches <baseline> at <threshold> percent
  When the mock relay sets composer status to idle
  Then the composer status header is not visible
  When the mock relay starts a composer turn
  Then the composer elapsed label reads Working 0:00
  When the mock relay sets composer status to idle
  Then the composer status header is not visible

Examples:
  | baseline                     | threshold |
  | composer-status-working-phone | 98        |

Scenario Outline: activity follows reasoning and tools without wrapping on phone
  When the mock relay sets composer status to processing
  And the mock relay begins composer reasoning
  Then the composer activity reads Thinking
  When the mock relay ends composer reasoning
  And the mock relay runs Bash with pnpm acceptance:visual
  Then the composer activity reads Bash · pnpm acceptance:visual
  When the mock relay finishes the composer tool
  Then the composer activity is not visible
  When the mock relay runs Read with <path>
  Then the composer activity reads Read · <path>
  And the composer activity is truncated to one line
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | path                                                                                              | baseline                      | threshold |
  | src/lib/frontend/components/input/a-very-long-directory-name/another-long-directory/InputArea.svelte | composer-status-activity-phone | 98        |

Scenario Outline: live control returns a detached transcript to the latest output
  When the mock relay sets composer status to processing
  Then the composer live control is not visible
  When I scroll the transcript up by 400 pixels
  Then the composer live control is visible
  When the mock relay streams composer output Latest streamed output
  Then the composer live control is visible
  And the composer region visually matches <baseline> at <threshold> percent
  When I tap the composer live control
  Then the transcript is pinned to the bottom
  And the composer live control is not visible
  And the latest composer output is visible

Examples:
  | baseline                 | threshold |
  | composer-status-live-phone | 98        |

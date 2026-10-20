Feature: The transcript carries live status above a single composer box

Background:
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  And I open a composer session
  And the composer status clock is frozen
  And the transcript is live
  And the transcript is pinned to the bottom

Scenario Outline: the live turn head follows the lifecycle and restarts its clock
  Then the composer status header is not visible
  And the live turn head is not visible
  When the mock relay starts a composer turn
  Then the live turn head is visible
  And the live turn elapsed label reads 0s
  And the composer status header is not visible
  When the composer status clock advances by 65 seconds
  Then the live turn elapsed label reads 1m 5s
  And the layout region visually matches <baseline> at <threshold> percent
  When the mock relay sets composer status to idle
  Then the live turn head is not visible
  When the mock relay starts a composer turn
  Then the live turn elapsed label reads 0s
  When the mock relay sets composer status to idle
  Then the live turn head is not visible

Examples:
  | baseline                       | threshold |
  | transcript-status-working-phone | 98        |

Scenario Outline: the step log carries current reasoning and tool activity on phone
  When the mock relay starts a composer turn
  And the mock relay begins composer reasoning
  And I expand the live turn step log
  Then the live turn step log shows active reasoning Consider the next step.
  When the mock relay ends composer reasoning
  And the mock relay runs Bash with pnpm acceptance:visual
  Then the live turn step log shows pnpm acceptance:visual
  When the mock relay finishes the composer tool
  And the mock relay runs Read with <path>
  Then the live turn step log shows <path>
  And the live turn running line is visible
  And the composer status header is not visible
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | path                                                                                              | baseline                        | threshold |
  | src/lib/frontend/components/input/a-very-long-directory-name/another-long-directory/InputArea.svelte | transcript-status-activity-phone | 98        |

Scenario Outline: Jump to live remains available when detached within a long live turn
  When the mock relay starts a composer turn
  And the mock relay streams a long composer turn
  Then the transcript is pinned to the bottom
  And the Jump to live control is not visible
  When I scroll the transcript up by 400 pixels
  Then the live turn still intersects the viewport
  And the Jump to live control is visible
  When the mock relay streams composer output Latest streamed output
  Then the Jump to live control is visible
  And the composer status header is not visible
  And the layout region visually matches <baseline> at <threshold> percent
  When I tap the Jump to live control
  Then the transcript is pinned to the bottom
  And the Jump to live control is not visible
  And the latest composer output is visible

Examples:
  | baseline                      | threshold |
  | transcript-status-jump-live-phone | 98        |

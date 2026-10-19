Feature: Desktop merged session bar

Scenario: Settle distinguishes keyboard focus from its resting capsule
  Given the conduit app is served with the long-transcript mockup
  Then the Settle segment shows a focus ring after tabbing and clears it after a pointer click

Scenario Outline: The merged bar contains the global actions
  Given the conduit app is served with the long-transcript mockup
  Then the desktop session bar remains one row
  And the desktop session controls sit in the right-hand group
  When I enable the desktop Debug action
  And I open the session overflow menu
  Then the desktop overflow lists Share, Settings and Debug panel in order
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                     | threshold |
  | desktop-session-bar-overflow | 98        |

Scenario: Scrolling to the bottom keeps the desktop bar in one row
  Given the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 400 pixels
  And I scroll the transcript back to the bottom
  Then the desktop session bar remains one row
  And the session header has no checkout
  And the session header has no account or instance control

Scenario Outline: header has no checkout
  Given the session loaded the skills "release-notes by you in turn 1; changelog-style by agent in turn 1; verify by agent in turn 2"
  And the conduit app is served with the connected mockup
  And a session already exists on the <harness> harness
  And the session has 2 Side Threads
  And the Claude accounts are claude as personal, self as work
  And a named OpenCode instance Bedrock is already configured
  And the composer uses words controls
  And the composer checkout is conduit / account-chip as worktree
  Then the composer checkout shows account-chip with a worktree icon
  And the skills chip reads 3 skills used
  And the session header has no checkout
  And the session header has no account or instance control
  And the desktop session bar remains one row
  And the desktop session controls sit in the right-hand group
  And the session-bar region visually matches <baseline> at <threshold> percent

Examples:
  | harness  | baseline                        | threshold |
  | Claude   | desktop-session-bar-a1-claude   | 98        |
  | OpenCode | desktop-session-bar-a1-opencode | 98        |

Scenario: header has no identity while its provider is loading
  Given the conduit app is served with the connected mockup
  And the session's provider lookup is held
  And a session already exists on the Claude harness
  And the Claude accounts are claude as personal, self as work
  Then the session header has no checkout
  And the session header has no account or instance control
  When the session's provider lookup answers
  Then the harness trigger shows the Claude instance icon
  And the session header has no checkout
  And the session header has no account or instance control

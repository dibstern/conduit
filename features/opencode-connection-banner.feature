Feature: OpenCode connection warnings follow the viewed session

Background:
  Given the viewport is a desktop
  And the conduit app is served with the connected mockup
  And the mock relay has Claude and OpenCode sessions

Scenario Outline: Reconnecting does not warn on a Claude session
  When I view the Claude session
  And the mock relay reports OpenCode reconnecting
  Then the OpenCode connection banner is not visible
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                         | threshold |
  | opencode-connection-banner-claude | 98        |

Scenario Outline: Reconnecting warns on an OpenCode session
  When I view the OpenCode session
  And the mock relay reports OpenCode reconnecting
  Then the OpenCode connection banner reads Reconnecting to OpenCode…
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                           | threshold |
  | opencode-connection-banner-opencode | 98        |

Scenario Outline: Switching to OpenCode during an outage shows the stored warning
  When I view the OpenCode session
  And I view the Claude session
  And the mock relay reports OpenCode reconnecting
  Then the OpenCode connection banner is not visible
  When I view the OpenCode session
  Then the OpenCode connection banner reads Reconnecting to OpenCode…
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                         | threshold |
  | opencode-connection-banner-switch | 98        |

Scenario Outline: Reconnecting successfully clears the warning
  When I view the OpenCode session
  And the mock relay reports OpenCode reconnecting
  Then the OpenCode connection banner reads Reconnecting to OpenCode…
  When the mock relay reports OpenCode connected
  Then the OpenCode connection banner is not visible
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                            | threshold |
  | opencode-connection-banner-connected | 98        |

Scenario: An outage without a viewed session shows no warning
  When the mock relay reports OpenCode reconnecting
  Then the OpenCode connection banner is not visible
  When the mock relay reports OpenCode failed
  Then the OpenCode connection banner is not visible

Scenario: A Claude session using an OpenCode project default shows no warning
  When I view the Claude session using the OpenCode project default
  And the mock relay reports OpenCode reconnecting
  Then the OpenCode connection banner is not visible
  When the mock relay reports OpenCode failed
  Then the OpenCode connection banner is not visible

Scenario: Failed warnings update and disappear when switching back to Claude
  When I view the Claude session
  And the mock relay reports OpenCode failed
  Then the OpenCode connection banner is not visible
  When I view the OpenCode session
  Then the OpenCode connection banner reads OpenCode failed to start
  When the mock relay reports OpenCode reconnecting
  Then the OpenCode connection banner reads Reconnecting to OpenCode…
  When I view the Claude session
  Then the OpenCode connection banner is not visible

Scenario: Stopped never shows a warning
  When I view the OpenCode session
  And the mock relay reports OpenCode reconnecting
  Then the OpenCode connection banner reads Reconnecting to OpenCode…
  When the mock relay reports OpenCode stopped
  Then the OpenCode connection banner is not visible

Scenario: A status for another instance shows no banner
  When I view the OpenCode session on instance work-oc
  And the mock relay reports OpenCode reconnecting
  Then the OpenCode connection banner is not visible
  When the mock relay reports OpenCode failed for instance other-oc
  Then the OpenCode connection banner is not visible
  When the mock relay reports OpenCode reconnecting for instance work-oc
  Then the OpenCode connection banner reads Reconnecting to OpenCode…

Scenario Outline: Starting shows a non-warning indicator
  When I view the OpenCode session
  And the mock relay reports OpenCode starting
  Then the OpenCode connection banner reads Starting OpenCode…
  And the OpenCode connection banner is not a warning
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                           | threshold |
  | opencode-connection-banner-starting | 98        |

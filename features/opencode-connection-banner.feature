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

Scenario: A Claude session using the OpenCode default model shows no warning
  When I view the Claude session using the OpenCode default model
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

Scenario: Rejected agent discovery still shows the viewed instance's stored warning
  Given the OpenCode session is persisted on instance work-oc with another instance healthy
  When the mock relay reports OpenCode reconnecting for instance work-oc
  And I view the OpenCode session on instance work-oc with rejected agent discovery
  Then the OpenCode connection banner reads Reconnecting to OpenCode…
  And the generic instance health warning is not visible
  When the mock relay reports OpenCode failed for instance work-oc
  Then the OpenCode connection banner reads OpenCode failed to start

Scenario: The relay's first OpenCode instance uses its connection alias when discovery fails
  Given the OpenCode session is persisted on instance work-oc as the first OpenCode instance with another instance healthy
  When the mock relay reports OpenCode reconnecting
  And I view the OpenCode session on instance work-oc with rejected agent discovery
  Then the OpenCode connection banner reads Reconnecting to OpenCode…
  And the generic instance health warning is not visible

Scenario: Rejected discovery on a persisted Claude instance does not show an OpenCode warning
  Given the Claude session is persisted on instance work-claude with another instance healthy
  When the mock relay reports OpenCode reconnecting
  And I view the Claude session on instance work-claude with rejected agent discovery
  Then the OpenCode connection banner is not visible

Scenario: The first send shows why the selected OpenCode instance cannot create a session
  Given the composer picker has the OpenCode catalog
  And creating a session on instance work-oc fails with CreateSession failed: OpenCode instance "work-oc" is unreachable at http://127.0.0.1:4555: connection refused
  When I type diagnose this outage into the composer
  And I send the composer message
  Then an error toast contains OpenCode instance "work-oc" is unreachable at http://127.0.0.1:4555: connection refused
  And the composer still contains diagnose this outage

Scenario Outline: Starting shows a non-warning indicator
  When I view the OpenCode session
  And the mock relay reports OpenCode starting
  Then the OpenCode connection banner reads Starting OpenCode…
  And the OpenCode connection banner is not a warning
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                           | threshold |
  | opencode-connection-banner-starting | 98        |

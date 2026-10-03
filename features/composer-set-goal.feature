Feature: Set a Claude goal from the composer

Scenario Outline: Set goal inserts the command and shows violet send controls on a phone
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  When I open the composer add menu
  And I select Set goal
  Then the composer contains the focused goal prefix
  And the composer shows goal send controls
  And the composer region visually matches <baseline> at <threshold> percent
  When I type <goal> into the composer
  And I send the composer message
  Then the mock relay replays the sent message for the selected session
  And the composer shows normal send controls

Examples:
  | goal                                        | baseline                | threshold |
  | /goal Make every acceptance scenario pass   | composer-set-goal-phone | 98        |

Scenario Outline: Typing a goal prefix enables violet send and editing the prefix reverts it
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  When I type <goal> into the composer
  Then the composer shows goal send controls
  When I type <message> into the composer
  Then the composer shows normal send controls
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | goal                           | message                   | baseline               | threshold |
  | /goal Finish the accessibility | Please explain /goal first | composer-goal-reverted | 98        |

Scenario Outline: OpenCode offers a disabled goal entry and never shows goal send controls
  Given the conduit app is served with the connected mockup
  And a session already exists on the OpenCode harness
  When I open the composer add menu
  Then the goal entry is disabled and reads Goal with Claude only
  When I try the disabled goal entry
  And I type <goal> into the composer
  Then the composer shows normal send controls
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | goal                       | baseline               | threshold |
  | /goal Finish this refactor | composer-goal-opencode | 98        |

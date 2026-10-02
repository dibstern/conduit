Feature: Composer context warnings follow the selected threshold and offer Claude compaction

Scenario Outline: phone Words controls warn at the selected context threshold
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I open settings to the Composer tab
  And I choose <threshold> for composer context warnings
  And I open settings to the Composer tab
  And I choose Words for composer controls
  And the mock relay reports context <percent> percent
  Then the composer context warning is <visibility>
  And the Words row context usage is <warning>
  When I open the model picker
  Then the picker context usage is <warning>

Examples:
  | threshold | percent | visibility  | warning    |
  | 60        | 59      | not visible | not warned |
  | 60        | 60      | visible     | warned     |
  | 70        | 69      | not visible | not warned |
  | 70        | 70      | visible     | warned     |
  | 80        | 79      | not visible | not warned |
  | 80        | 80      | visible     | warned     |
  | 90        | 89      | not visible | not warned |
  | 90        | 92      | visible     | warned     |
  | default   | 85      | visible     | warned     |

Scenario: Never suppresses high context warnings in the composer and picker
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I open settings to the Composer tab
  And I choose Never for composer context warnings
  And I open settings to the Composer tab
  And I choose Words for composer controls
  And the mock relay reports context 97 percent
  Then the composer context warning is not visible
  And the Words row context usage is not warned
  When I open the model picker
  Then the picker context usage is not warned

Scenario Outline: Claude Compact sends the slash command and yields to the transcript notice
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the mock relay reports context 85 percent
  Then the composer context warning is visible
  And the composer context warning reads Context 85% full. Older turns compact soon.
  When I press Compact in the composer context warning
  Then the Compact RPC sends exactly /compact for the current session
  When the mock relay starts compaction for the current session
  Then the composer context warning is not visible
  And the transcript has a Compacting notice
  When the mock relay <outcome> compaction for the current session
  Then the composer context warning is visible
  And the composer context warning reads Context <percent>% full. Older turns compact soon.

Examples:
  | outcome   | percent |
  | fails     | 85      |
  | completes | 82      |

Scenario: OpenCode shows the high context warning without a Compact action
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the OpenCode harness
  And the composer picker has the OpenCode catalog
  When the mock relay reports context 85 percent
  Then the composer context warning is visible
  And the composer context warning reads Context 85% full. Older turns compact soon.
  And the composer Compact action is absent

Scenario Outline: phone Icons controls show the context warning above the field
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the mock relay reports context 85 percent
  Then the composer context warning is visible
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                       | threshold |
  | composer-context-warning-phone | 98        |

Scenario Outline: phone Words controls show the context warning and usage below it
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I open settings to the Composer tab
  And I choose Words for composer controls
  And the mock relay reports context 85 percent
  Then the composer context warning is visible
  And the Words row context usage is warned
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                             | threshold |
  | composer-context-warning-words-phone | 98        |

Scenario Outline: desktop Icons controls show the context warning above the field
  Given the viewport is a desktop
  And the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the mock relay reports context 85 percent
  Then the composer context warning is visible
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                         | threshold |
  | composer-context-warning-desktop | 98        |

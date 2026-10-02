Feature: Composer effort meter cycles levels and offers every level on hold

Background:
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness

Scenario Outline: bar count follows model options and Default leaves every bar empty
  Given the model offers effort levels <levels>
  Then the effort meter shows DEF
  And the effort meter has <bars> bars with 0 filled

Examples:
  | levels                        | bars |
  | low, medium, high, max         | 4    |
  | low, medium, high, xhigh, max  | 5    |

Scenario Outline: tapping cycles through levels and skips Default on wrap
  Given the model offers effort levels low, medium, high, xhigh, max
  When I set effort to <current>
  And I tap the effort meter
  Then the effort meter shows <next>
  And the effort meter has 5 bars with <filled> filled
  And the effort menu is closed

Examples:
  | current | next  | filled |
  | default | LOW   | 1      |
  | low     | MED   | 2      |
  | medium  | HIGH  | 3      |
  | high    | XHIGH | 4      |
  | xhigh   | MAX   | 5      |
  | max     | LOW   | 1      |

Scenario: Ctrl+T wraps from Max to Low without landing on Default
  Given the model offers effort levels low, medium, high, xhigh, max
  When I set effort to max
  And I cycle effort with Ctrl+T
  Then the effort meter shows LOW
  And the effort meter has 5 bars with 1 filled
  And the effort menu is closed

Scenario: holding offers Default and every level with descriptions and selection closes
  Given the model offers effort levels low, medium, high, xhigh, max
  When I set effort to high
  And I hold the effort meter
  Then the effort menu lists Default and every offered level
  And the effort meter shows HIGH
  And the effort option default describes Use the model default
  And the effort option low describes Quick, light reasoning
  And the effort option medium describes Balanced
  And the effort option high describes Thinks harder, slower
  And the effort option xhigh describes Deeper still, for hard problems
  And the effort option max describes Most thorough, slowest
  When I set effort to default
  Then the effort meter shows DEF
  And the effort meter has 5 bars with 0 filled
  And the effort menu is closed

Scenario: an unknown level uses its first five characters as the micro label
  Given the model offers effort levels low, medium, thorough
  When I set effort to thorough
  Then the effort meter shows THORO
  And the effort meter has 3 bars with 3 filled
  When I hold the effort meter
  Then the effort menu lists Default and every offered level
  And the effort option thorough describes Custom reasoning effort

Scenario: a failed effort switch rolls back the label and meter and remains usable
  Given the model offers effort levels low, medium, high, xhigh, max
  When I set effort to high
  Given the provider rejects the next effort switch
  When I tap the effort meter
  Then the failed effort switch to xhigh is reported
  And the effort meter shows HIGH
  And the effort meter has 5 bars with 3 filled
  And the effort menu is closed
  When I tap the effort meter
  Then the effort meter shows XHIGH
  And the effort meter has 5 bars with 4 filled

Scenario Outline: the phone meter matches the approved chip and micro label
  Given the model offers effort levels low, medium, high, xhigh, max
  When I set effort to high
  Then the effort meter shows HIGH
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                  | threshold |
  | composer-effort-high-phone | 98       |

Feature: Phone composer effort moves into the sheet and shared picker

Background:
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness

Scenario Outline: bar count follows model options and Default leaves every bar empty
  Given the model offers effort levels <levels>
  When I open the phone composer sheet
  Then the phone composer Effort row reads Default
  And the effort meter has <bars> bars with 0 filled
  When I tap the phone composer Effort row
  Then the picker lists every offered effort level
  And no effort segment in the picker is selected

Examples:
  | levels                        | bars |
  | low, medium, high, max         | 4    |
  | low, medium, high, xhigh, max  | 5    |

Scenario Outline: Ctrl+T cycles through levels and skips Default on wrap while the sheet is closed
  Given the model offers effort levels low, medium, high, xhigh, max
  When I set effort to <current>
  Then the phone composer sheet is closed
  When I cycle effort with Ctrl+T
  And I open the phone composer sheet
  Then the phone composer Effort row reads <next>
  And the effort meter has 5 bars with <filled> filled
  And the effort menu is closed

Examples:
  | current | next  | filled |
  | low     | medium | 2      |
  | medium  | high   | 3      |
  | high    | xhigh  | 4      |
  | xhigh   | max    | 5      |
  | max     | low    | 1      |

Scenario: Ctrl+T selects Low from Default without opening the sheet
  Given the model offers effort levels low, medium, high, xhigh, max
  When I cycle effort with Ctrl+T
  Then the phone composer sheet is closed
  When I open the phone composer sheet
  Then the phone composer Effort row reads low
  And the effort meter has 5 bars with 1 filled
  And the effort menu is closed

Scenario: the phone sheet Effort row opens the picker and selection keeps its root open
  Given the model offers effort levels low, medium, high, xhigh, max
  When I set effort to high
  And I tap the phone composer Effort row
  Then the picker lists every offered effort level
  And the picker effort high is selected while the root remains open
  When I select effort max in the picker
  Then the picker effort max is selected while the root remains open
  When I close the model picker
  And I open the phone composer sheet
  Then the phone composer Effort row reads max
  And the effort meter has 5 bars with 5 filled
  And the effort menu is closed

Scenario: an unknown effort level keeps its full name in the sheet
  Given the model offers effort levels low, medium, thorough
  When I set effort to thorough
  And I open the phone composer sheet
  Then the phone composer Effort row reads thorough
  And the effort meter has 3 bars with 3 filled
  When I tap the phone composer Effort row
  Then the picker lists every offered effort level
  And the picker effort thorough is selected while the root remains open

Scenario: a failed effort switch rolls back the label and meter and remains usable
  Given the model offers effort levels low, medium, high, xhigh, max
  When I set effort to high
  Given the provider rejects the next effort switch
  When I tap the phone composer Effort row
  And I select effort xhigh in the picker
  Then the failed effort switch to xhigh is reported
  And the picker effort high is selected while the root remains open
  When I close the model picker
  And I open the phone composer sheet
  Then the phone composer Effort row reads high
  And the effort meter has 5 bars with 3 filled
  And the effort menu is closed
  When I tap the phone composer Effort row
  And I select effort xhigh in the picker
  Then the picker effort xhigh is selected while the root remains open
  When I close the model picker
  And I open the phone composer sheet
  Then the phone composer Effort row reads xhigh
  And the effort meter has 5 bars with 4 filled

Scenario Outline: the phone sheet effort row shows the bars and lowercase value
  Given the model offers effort levels low, medium, high, xhigh, max
  When I set effort to high
  And I open the phone composer sheet
  Then the phone composer Effort row reads high
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                  | threshold |
  | composer-effort-high-sheet | 98       |

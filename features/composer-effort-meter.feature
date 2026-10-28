Feature: Composer effort cycles directly and keeps options in the shared picker

Background:
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness

Scenario: desktop clicks raise effort and wrap without opening the picker
  Given the harness logo is viewed in the wide tier
  And the composer uses icons controls
  And the model offers effort levels low, medium, high, xhigh, max
  When I set effort to high
  And I click the effort control
  Then the effort control names Extra high
  And the shared composer picker is closed
  When I click the effort control
  Then the effort control names Max
  And the shared composer picker is closed
  When I click the effort control
  Then the effort control names Low
  And the shared composer picker is closed

Scenario Outline: desktop keyboard activation raises effort without opening the picker
  Given the harness logo is viewed in the wide tier
  And the composer uses icons controls
  And the model offers effort levels low, medium, high, xhigh, max
  When I set effort to high
  And I press <key> on the effort control
  Then the effort control names Extra high
  And the shared composer picker is closed

Examples:
  | key   |
  | Enter |
  | Space |

Scenario Outline: desktop effort options focus Effort and return focus to the control
  Given the harness logo is viewed in the wide tier
  And the composer uses icons controls
  And the model offers effort levels low, medium, high, xhigh, max
  When I set effort to high
  And I <gesture> the effort control
  Then the icons control opens the picker at Effort
  And the effort control names High
  When I close the model picker
  Then the icons effort control is focused

Examples:
  | gesture            |
  | Option-click       |
  | press Shift+F10 on |

Scenario: phone tap raises effort and hold opens options without raising again
  Given the composer uses icons controls
  And the model offers effort levels low, medium, high, xhigh, max
  When I set effort to high
  And I tap the phone footer effort control
  Then the effort control names Extra high
  And the shared composer picker is closed
  When I hold the phone footer effort control
  Then the icons control opens the picker at Effort
  And the picker effort xhigh is selected while the root remains open
  And the effort control names Extra high
  When I close the model picker
  And I tap the phone footer effort control
  Then the effort control names Max
  And the shared composer picker is closed

Scenario Outline: the picker follows model options and Default leaves every level unselected
  Given the model offers effort levels <levels>
  When I open the phone composer sheet
  Then the phone composer Effort row reads Default
  When I tap the phone composer Effort row
  Then the picker lists every offered effort level
  And no effort segment in the picker is selected

Examples:
  | levels                       |
  | low, medium, high, max        |
  | low, medium, high, xhigh, max |

Scenario Outline: Ctrl+T cycles through levels and skips Default on wrap while the sheet is closed
  Given the model offers effort levels low, medium, high, xhigh, max
  When I set effort to <current>
  Then the phone composer sheet is closed
  When I cycle effort with Ctrl+T
  And I open the phone composer sheet
  Then the phone composer Effort row reads <next>
  And the effort menu is closed
  When I tap the phone composer Effort row
  Then the picker lists every offered effort level
  And the picker effort <next> is selected while the root remains open

Examples:
  | current | next   |
  | low     | medium |
  | medium  | high   |
  | high    | xhigh  |
  | xhigh   | max    |
  | max     | low    |

Scenario: Ctrl+T selects Low from Default without opening the sheet
  Given the model offers effort levels low, medium, high, xhigh, max
  When I cycle effort with Ctrl+T
  Then the phone composer sheet is closed
  When I open the phone composer sheet
  Then the phone composer Effort row reads low
  And the effort menu is closed
  When I tap the phone composer Effort row
  Then the picker lists every offered effort level
  And the picker effort low is selected while the root remains open

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
  And the effort menu is closed

Scenario: an unknown effort level keeps its full name in the sheet
  Given the model offers effort levels low, medium, thorough
  When I set effort to thorough
  And I open the phone composer sheet
  Then the phone composer Effort row reads thorough
  When I tap the phone composer Effort row
  Then the picker lists every offered effort level
  And the picker effort thorough is selected while the root remains open

Scenario: a failed effort switch rolls back the selected value and remains usable
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
  And the effort menu is closed
  When I tap the phone composer Effort row
  And I select effort xhigh in the picker
  Then the picker effort xhigh is selected while the root remains open
  When I close the model picker
  And I open the phone composer sheet
  Then the phone composer Effort row reads xhigh
  When I tap the phone composer Effort row
  Then the picker lists every offered effort level
  And the picker effort xhigh is selected while the root remains open

Scenario Outline: the phone sheet effort row shows its lowercase value
  Given the model offers effort levels low, medium, high, xhigh, max
  When I set effort to high
  And I open the phone composer sheet
  Then the phone composer Effort row reads high
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                  | threshold |
  | composer-effort-high-sheet | 98       |

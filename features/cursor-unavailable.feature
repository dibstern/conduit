Feature: Cursor is listed safely before its runtime is installed

Scenario Outline: the provider rail shows Cursor unavailable with its reason
  Given the conduit app is served with the connected mockup
  And a Cursor account is registered without a runtime
  And the harness logo is viewed in the <tier> tier
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  Then the Cursor provider rail choice is unavailable with reason <reason>
  And the model-picker region visually matches cursor-unavailable-rail at <threshold> percent

Examples:
  | tier  | reason                       | threshold |
  | wide  | Cursor runtime not installed | 98        |
  | phone | Cursor runtime not installed | 98        |

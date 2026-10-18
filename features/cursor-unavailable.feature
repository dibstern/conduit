Feature: Cursor discovery explains why it is unavailable

Scenario Outline: the provider rail shows Cursor unavailable with its reason
  Given the conduit app is served with the connected mockup
  And a Cursor account is unavailable with reason <reason>
  And the harness logo is viewed in the <tier> tier
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  Then the Cursor provider rail choice is unavailable with reason <reason>
  And the model-picker region visually matches cursor-unavailable-rail at <threshold> percent

Examples:
  | tier  | reason                    | threshold |
  | wide  | Cursor SDK could not load | 98        |
  | phone | Cursor SDK could not load | 98        |

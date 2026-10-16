Feature: Cursor discovery offers its live models for a new session

Scenario Outline: pick Cursor and a live model on desktop and phone
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  Then the Cursor provider rail choice is available
  When I select the Cursor Harness tab in the picker
  Then the Cursor Harness tab is selected and in view
  And the model-picker region visually matches cursor-available-rail at <threshold> percent
  When I view Model choices in the picker
  Then the Cursor model list contains exactly Composer 2.5, Grok 4.7
  And the model-picker region visually matches cursor-available-models at <threshold> percent
  When I select model <model> in the picker
  And I close the model picker
  Then the draft composer uses Cursor with model <model_id>

Examples:
  | tier  | model        | model_id     | threshold |
  | wide  | Composer 2.5 | composer-2.5 | 98        |
  | phone | Grok 4.7     | grok-4.7     | 98        |

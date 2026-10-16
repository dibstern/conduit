Feature: Cursor model parameters use the shared effort picker

Scenario Outline: choose a Cursor model and change its parameters for the next turn
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And the Cursor parameter catalogue is ready for <model>
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Cursor Harness tab in the picker
  And I view Model choices in the picker
  And I select model <name> in the picker
  Then the shared effort picker offers Cursor choices <choices>
  And the Cursor parameter options fit inside the model picker
  And the screen region visually matches cursor-parameters-<tier>-<shot> at <threshold> percent
  When I choose Cursor parameters <first> in the shared picker
  And I close the model picker
  Then the draft composer uses Cursor with model <model>
  When I type First Cursor turn into the composer
  And I send the composer message
  Then the Cursor session is created with model <model> and parameters <first>
  When the Cursor relay starts the sent turn
  And the Cursor relay streams text First reply
  And the Cursor relay completes the turn
  Then the Cursor composer is idle
  When I open the model picker
  And I choose Cursor parameters <next> in the shared picker
  Then the Cursor parameter switch to <next> is sent for the same session
  When I close the model picker
  And I type Next Cursor turn into the composer
  And I send the composer message
  Then the same Cursor session receives its second turn
  And no project-loading error toast is shown

Examples:
  | tier  | model        | shot     | threshold | name         | choices                                                                               | first    | next         |
  | wide  | composer-2.5 | composer | 98        | Composer 2.5 | Standard, Fast                                                                        | Standard | Fast         |
  | phone | composer-2.5 | composer | 98        | Composer 2.5 | Standard, Fast                                                                        | Standard | Fast         |
  | wide  | grok-4.6     | grok     | 98        | Grok 4.6     | low, low · Fast, medium, medium · Fast, high, high · Fast, xhigh, xhigh · Fast            | low      | high · Fast  |
  | phone | grok-4.6     | grok     | 98        | Grok 4.6     | low, low · Fast, medium, medium · Fast, high, high · Fast, xhigh, xhigh · Fast            | low      | high · Fast  |

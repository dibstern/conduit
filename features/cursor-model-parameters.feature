Feature: Cursor model parameters have separate picker rows

Scenario Outline: choose Cursor parameters for the first and next turn
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And the composer uses words controls
  And the Cursor parameter catalogue is ready for <model>
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Cursor Harness tab in the picker
  And I view Model choices in the picker
  And I select model <name> in the picker
  Then the Cursor parameter rows offer <rows>
  And the Cursor rows show <defaults>
  When I choose Cursor values <first_values> in the picker
  Then the Cursor parameter options fit inside the model picker
  And the screen region visually matches cursor-parameters-<tier>-<shot> at <threshold> percent
  When I close the model picker
  Then the draft composer uses Cursor with model <model>
  And the Cursor composer words show context <first_context> and effort <first_effort>
  And the Cursor composer stores combination <first>
  When I type First Cursor turn into the composer
  And I send the composer message
  Then the Cursor session is created with model <model> and parameters <first>
  When the Cursor relay starts the sent turn
  And the Cursor relay streams text First reply
  And the Cursor relay completes the turn
  Then the Cursor composer is idle
  When I open the model picker
  Then the Cursor rows show <first_values>
  When I choose Cursor values <next_values> in the picker
  Then the Cursor parameter switch to <next> is sent for the same session
  When I close the model picker
  Then the Cursor composer words show context <next_context> and effort <next_effort>
  And the Cursor composer stores combination <next>
  When I type Next Cursor turn into the composer
  And I send the composer message
  Then the same Cursor session receives its second turn
  And no project-loading error toast is shown

Examples:
  | tier  | model        | shot     | threshold | name         | rows                                                                     | defaults                              | first_values                              | first              | first_context | first_effort | next_values                            | next                 | next_context | next_effort |
  | wide  | composer-2.5 | composer | 98        | Composer 2.5 | fast=false/true                                                          | fast=false                            | fast=true                                 | Fast               | absent        | Fast         | fast=false                             | Standard             | absent       | Standard    |
  | phone | composer-2.5 | composer | 98        | Composer 2.5 | fast=false/true                                                          | fast=false                            | fast=true                                 | Fast               | absent        | Fast         | fast=false                             | Standard             | absent       | Standard    |
  | wide  | grok-4.7     | grok     | 98        | Grok 4.7     | context=256k/500k; effort=low/medium/high/xhigh; fast=false/true         | context=500k, effort=high, fast=false | context=256k, effort=high, fast=true      | 256K · high · Fast | 256K          | high · Fast  | context=500k, effort=xhigh, fast=false | 500K · xhigh         | 500K         | xhigh       |
  | phone | grok-4.7     | grok     | 98        | Grok 4.7     | context=256k/500k; effort=low/medium/high/xhigh; fast=false/true         | context=500k, effort=high, fast=false | context=256k, effort=high, fast=true      | 256K · high · Fast | 256K          | high · Fast  | context=500k, effort=xhigh, fast=false | 500K · xhigh         | absent       | xhigh       |
  | wide  | gpt-5.5      | gpt      | 98        | GPT-5.5      | context=272k/1m; effort=none/low/medium/high/extra-high; fast=false/true | context=1m, effort=medium, fast=false | context=1m, effort=extra-high, fast=false | 1M · extra-high    | 1M            | extra-high   | context=272k, effort=medium, fast=true | 272K · medium · Fast | 272K         | med · Fast  |
  | phone | gpt-5.5      | gpt      | 98        | GPT-5.5      | context=272k/1m; effort=none/low/medium/high/extra-high; fast=false/true | context=1m, effort=medium, fast=false | context=1m, effort=extra-high, fast=false | 1M · extra-high    | absent        | extra-high   | context=272k, effort=medium, fast=true | 272K · medium · Fast | 272K         | med · Fast  |

Scenario Outline: GPT-5.5 disables combinations absent from its catalogue
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And the composer uses words controls
  And the Cursor parameter catalogue is ready for gpt-5.5
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Cursor Harness tab in the picker
  And I view Model choices in the picker
  And I select model GPT-5.5 in the picker
  And I choose Cursor values context=1m in the picker
  Then the Cursor fast option true is disabled
  When I choose Cursor values context=272k in the picker
  Then the Cursor fast option true is enabled
  When I choose Cursor values fast=true in the picker
  Then the Cursor context option 1m is disabled
  And the Cursor rows show context=272k, effort=medium, fast=true
  And the Cursor parameter options fit inside the model picker

Examples:
  | tier  |
  | wide  |
  | phone |

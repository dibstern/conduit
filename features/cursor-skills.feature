Feature: Cursor skills use the shared composer command picker

Scenario Outline: Cursor skills stay scoped to their account and send as slash commands
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the Cursor turn relay is ready
  And the Cursor account has skills cursor-review and nested-audit
  And the harness logo is viewed in the <tier> tier
  When I start a new session
  And I type / into the composer
  Then the command menu offers /commit
  And the command menu does not offer /cursor-review
  When I clear the composer
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Cursor Harness tab in the picker
  And I view Model choices in the picker
  And I select model Composer 2.5 in the picker
  And I close the model picker
  Then the draft composer uses Cursor with model composer-2.5
  When I type / into the composer
  Then the Cursor command menu lists exactly /cursor-review, /nested-audit
  And the command menu does not offer /commit
  When I pick the Cursor skill cursor-review
  Then the composer contains the Cursor invocation /cursor-review
  When I append inspect this change to the Cursor invocation
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  And the relay receives the sent text /cursor-review inspect this change

Examples:
  | tier  |
  | wide  |
  | phone |

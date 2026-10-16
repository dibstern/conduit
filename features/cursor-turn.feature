Feature: Cursor streams a turn and accepts an interrupt

Scenario Outline: send with the selected Cursor model and receive a streamed reply
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And the Cursor turn relay is ready
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Cursor Harness tab in the picker
  And I view Model choices in the picker
  And I select model Composer 2.5 in the picker
  And I close the model picker
  Then the draft composer uses Cursor with model composer-2.5
  And the composer explains that Cursor runs without per-call approval
  When I type Say hello into the composer
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  And the relay receives the sent text Say hello
  When the Cursor relay starts the sent turn
  And the Cursor relay streams thinking Considering
  Then the Cursor thinking contains Considering
  When the Cursor relay streams thinking  the answer.
  Then the Cursor thinking contains Considering the answer.
  When the Cursor relay streams text Hello
  Then the transcript shows Hello
  When the Cursor relay streams text , Cursor.
  Then the transcript shows Hello, Cursor.
  When the Cursor relay completes the turn
  Then the Cursor composer is idle
  And the transcript shows Hello, Cursor.
  And the composer explains that Cursor runs without per-call approval

Examples:
  | tier  |
  | wide  |
  | phone |

Scenario Outline: interrupt a streaming Cursor reply
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And the Cursor turn relay is ready
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Cursor Harness tab in the picker
  And I view Model choices in the picker
  And I select model Composer 2.5 in the picker
  And I close the model picker
  And I type Keep writing into the composer
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  And the relay receives the sent text Keep writing
  When the Cursor relay starts the sent turn
  And the Cursor relay streams text Still writing
  Then the transcript shows Still writing
  When I interrupt the Cursor turn
  Then the relay receives the Cursor interrupt
  When the Cursor relay confirms the interrupt
  Then the Cursor composer is idle
  And the transcript shows Still writing

Examples:
  | tier  |
  | wide  |
  | phone |

Feature: Cursor reports turn usage and failures and recovers after an interrupt

Scenario Outline: read Cursor tokens and context with account-dependent cost
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
  And I type Explain usage into the composer
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  When the Cursor relay reports a completed turn with <cost> cost
  Then the transcript shows Usage reported.
  And the Cursor turn shows 1.2k input tokens and 340 output tokens
  And the Cursor turn cost is <cost>
  And the Cursor turn shows 120k context tokens without a reported capacity
  And the Cursor transcript has no error notice
  And the Cursor composer is idle

Examples:
  | tier  | cost        |
  | wide  | 0.0025      |
  | phone | 0.0025      |
  | wide  | unavailable |
  | phone | unavailable |

Scenario Outline: show Cursor diagnostics and whether retrying helps
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
  And I type Try this turn into the composer
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  When the Cursor relay fails with <diagnostic> and <guidance>
  Then the Cursor error notice contains <diagnostic>
  And the Cursor error notice contains <guidance>
  And the Cursor composer is idle

Examples:
  | tier  | diagnostic                                          | guidance                          |
  | wide  | Cursor authentication failed.                       | Resolve this error before retrying. |
  | phone | Cursor authentication failed.                       | Resolve this error before retrying. |
  | wide  | Cursor rate limit reached.                          | You can retry this turn.          |
  | phone | Cursor rate limit reached.                          | You can retry this turn.          |
  | wide  | The selected Cursor model is unavailable.           | Resolve this error before retrying. |
  | phone | The selected Cursor model is unavailable.           | Resolve this error before retrying. |
  | wide  | connection_stalled: transport diagnostic retained.   | You can retry this turn.          |
  | phone | connection_stalled: transport diagnostic retained.   | You can retry this turn.          |

Scenario Outline: send another Cursor message after a fallback interrupt
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
  When the Cursor relay starts the sent turn
  And the Cursor relay streams text Partial reply
  And I interrupt the Cursor turn
  Then the relay receives the Cursor interrupt
  When the Cursor relay confirms the interrupt
  Then the Cursor composer is idle
  And the transcript shows Partial reply
  When I type Continue after interrupt into the composer
  And I send the composer message
  Then the relay receives the sent text Continue after interrupt
  And the Cursor transcript has no error notice

Examples:
  | tier  |
  | wide  |
  | phone |

Feature: Cursor asks clarifying questions in the parent session

Background:
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the Cursor turn relay is ready
  And the Cursor question relay is ready

Scenario Outline: answer a Cursor question from desktop or phone
  Given the harness logo is viewed in the <tier> tier
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Cursor Harness tab in the picker
  And I view Model choices in the picker
  And I select model Composer 2.5 in the picker
  And I close the model picker
  And I type Ask which database to use into the composer
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  When the Cursor relay starts the sent turn
  And the Cursor relay asks a question headed <header>
  Then the Cursor question shows header <header>
  And the Cursor question prompt fits the viewport
  And the messages region visually matches cursor-question-<tier>-<kind> at <threshold> percent
  When I answer the Cursor question with <kind> <answer>
  Then the relay receives the Cursor question answer <answer>
  And the Cursor question is cleared after answering
  When the Cursor relay continues after the answer <answer>
  Then the transcript shows Using <answer>.
  When the Cursor relay completes the turn
  Then the Cursor composer is idle
  And the Cursor question has no answer controls

Examples:
  | tier  | header            | kind   | answer     | threshold |
  | wide  | Database          | option | PostgreSQL | 98        |
  | phone | Explore: Database | option | PostgreSQL | 98        |
  | wide  | Explore: Database | custom | SQLite     | 98        |
  | phone | Database          | custom | SQLite     | 98        |

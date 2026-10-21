Feature: Codex asks questions while continuing its work

Background:
  Given the conduit app is served with the connected mockup
  And the Codex async question relay is ready
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Codex Harness tab in the picker
  And I view Model choices in the picker
  And I select model GPT-5.5 in the picker
  And I close the model picker
  And I type Investigate the database options into the composer
  And I send the composer message
  And the Codex relay asks two async questions

Scenario Outline: answer an async question after the agent finishes
  Given the harness logo is viewed in the <tier> tier
  Then the Codex async card says Answer anytime
  And the messages region visually matches codex-async-question-<tier>-<kind> at <threshold> percent
  When the Codex relay completes the turn with the async question pending
  Then the Codex async question leaves the composer idle
  And the Codex async card says Answer anytime
  When I answer the Codex async question with <kind> <answer> and context <context>
  Then the Codex async answer is sent as <answer> with context <context>
  And the Codex async question has no answer controls

Examples:
  | tier  | kind   | answer     | context          | threshold |
  | wide  | option | PostgreSQL | Keep it simple   | 98        |
  | phone | option | SQLite     | Keep it local    | 98        |
  | wide  | custom | MongoDB    | Use documents    | 98        |
  | phone | custom | DuckDB     | Analyse the data | 98        |

Scenario Outline: dismiss an async question without sending a message
  Given the harness logo is viewed in the <tier> tier
  Then the Codex async card says Answer anytime
  When the Codex relay completes the turn with the async question pending
  And I dismiss the Codex async question
  Then the Codex async question is dismissed without a message
  And the Codex async question has no answer controls
  And the messages region visually matches codex-async-question-<tier>-dismissed at <threshold> percent

Examples:
  | tier  | threshold |
  | wide  | 98        |
  | phone | 98        |

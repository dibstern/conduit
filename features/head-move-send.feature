Feature: A send during a head move waits for the move to land

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: a send during a head move is queued, never interleaved, and starts once the move lands
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the conversation is moving to another point
  When I type <text> into the composer
  And I send the composer message
  Then the pending-input tray has 1 row
  And pending-input row 1 reads <text>
  And the transcript has no user message <text>
  When the move lands and the held message <text> starts
  Then the pending-input tray is not visible
  And the transcript shows <text>

Examples:
  | viewport | text                                  |
  | phone    | Summarise the branch after the rewind |
  | desktop  | Summarise the branch after the rewind |

Scenario Outline: an undo during a head move says why it was refused
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the session has a rewind to undo
  And the conversation is moving to another point
  When I undo the rewind
  Then the undo is refused with <reason>

Examples:
  | viewport | reason                                                                   |
  | phone    | The conversation is still moving to another point. Try again in a moment. |
  | desktop  | The conversation is still moving to another point. Try again in a moment. |

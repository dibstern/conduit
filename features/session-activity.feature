Feature: The chat and composer read what the session is doing, not its stored status

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: Claude's wake turn shows Stop and lets a queued message steer while the stored status reads idle
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When Claude's wake turn runs while the stored status reads idle
  Then the stop button is visible
  When the mock relay queues <text>
  Then pending-input row 1 offers an enabled Steer

Examples:
  | viewport | text                    |
  | phone    | Check the logs as well  |
  | desktop  | Check the logs as well  |

Scenario Outline: Only background tasks running shows Send, not Stop, while the stored status reads busy
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When only background tasks run while the stored status reads busy
  Then the stop button is not visible
  And the send button reads Send

Examples:
  | viewport |
  | phone    |
  | desktop  |

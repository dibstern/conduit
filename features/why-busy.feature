Feature: Why busy shows Session Activity's answer beside the busy indicator

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: The view lists the Run with its queued message, the background work and only the open tool call
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the transcript has a turn with one open step and one step the run ended
  And the mock relay queues <queued_text>
  When the session answers a message beside background work <task>
  And I open why the session is busy
  Then why the session is busy reads "Answering your message" then "Background work running"
  And why the session is busy shows "1 message queued behind it"
  And why the session is busy shows "<task>"
  And why the session is busy lists the open tool call "Bash" only

Examples:
  | viewport | queued_text            | task          |
  | phone    | Check the logs as well | sleep 8       |
  | desktop  | Check the logs as well | tail the logs |

Scenario Outline: The view closes when the indicator turns calm, though background work and an open step remain
  Given the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the transcript has a turn with one open step and one step the run ended
  When the session answers a message beside background work sleep 8
  Then the session bar offers a why-busy view
  When the session failed beside background work sleep 8
  Then the session bar offers no why-busy view

Examples:
  | viewport |
  | phone    |
  | desktop  |

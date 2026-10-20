Feature: Sent messages keep recognised skills as pills

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: a sent message renders recognised skills as pills and leaves other slash tokens plain
  Given the composer picker has the OpenCode catalog
  When I type <message> into the composer
  And I send the composer message
  And the mock relay replays the sent message for the selected session
  Then the transcript shows <message>
  And the mock avatar and message clock match the fixed acceptance fixture
  And the last-user-message region visually matches <baseline> at <threshold> percent

Examples:
  | message                              | baseline                   | threshold |
  | run /commit then /comit and /qwerty | transcript-skill-pill-dark | 98        |

Scenario: Generated events stay in order after the scenario clock advances
  Given I open a composer session
  And the composer status clock is frozen
  When the mock relay starts a composer turn
  And the mock relay streams composer output The fixed-clock reply
  Then generated messages follow the scenario clock in arrival order

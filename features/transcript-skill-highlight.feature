Feature: Sent messages keep recognised skills as pills

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: a sent message renders recognised skills as pills and leaves other slash tokens plain
  When I type <message> into the composer
  And I send the composer message
  Then the transcript shows <message>
  And the last-user-message region visually matches <baseline> at <threshold> percent

Examples:
  | message                              | baseline                   | threshold |
  | run /commit then /comit and /qwerty | transcript-skill-pill-dark | 98        |

Feature: A turn waits quietly until its first step

Scenario Outline: A sent prompt with no events shows Sending immediately
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent <send_seconds> seconds ago
  Then the turn opening reads Sending… without a card or timer
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | send_seconds | baseline             | threshold |
  | 5            | turn-opening-sending | 98        |

Scenario Outline: The first ordinary step replaces Sending and counts time from send
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent <send_seconds> seconds ago
  Then the turn opening reads Sending… without a card or timer
  When the first ordinary turn opening step arrives
  Then the turn opening is replaced by a Working card timed <elapsed>
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | send_seconds | elapsed | baseline             | threshold |
  | 5            | 5s      | turn-opening-working | 98        |

Scenario Outline: Replacing the pulse keeps the prompt and head in place
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent 5 seconds ago
  Then the turn opening reads Sending… without a card or timer
  When I record the turn opening prompt and head positions
  And the first ordinary turn opening step arrives
  Then the turn opening is replaced by a Working card timed 5s
  And the turn opening prompt bounding box is unchanged
  And the Working head occupies the opening pulse row

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario: The opening pulse stays still under reduced motion
  Given the conduit app is served with the connected mockup
  And reduced motion is enabled for the turn opening
  And the turn opening prompt was sent 5 seconds ago
  Then the turn opening reads Sending… without a card or timer
  And the turn opening has no running animation

Scenario: A notice before the first step changes the opening to Working
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent 5 seconds ago
  When a retry notice arrives before the first step
  Then the turn opening reads Working without a card or timer
  And the retry notice follows the turn opening

Scenario: A busy session with no transcript rows still shows Sending
  Given the conduit app is served with the connected mockup
  And the turn opening session is busy with no transcript rows
  Then the turn opening reads Sending… without a card or timer

Scenario: A first send waiting for the transcript still shows Sending
  Given the transcript feed will hold
  And the conduit app is served with the connected mockup
  And the composer picker has the OpenCode catalog
  And session creation takes 400 ms
  When I send Hello from a draft from the composer, watching the transcript for 1200 ms
  Then the sent message showed within 100 ms and stayed, with no loading skeleton
  And the turn opening reads Sending… without a card or timer
  When the draft turn opening is reported busy
  And the server places the sent message in the new session
  Then the transcript shows the sent message exactly once
  And the turn opening reads Sending… without a card or timer

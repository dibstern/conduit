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
  And the assistant name row occupies the opening row

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

Scenario Outline: Compaction before the first step is a live rule
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent 5 seconds ago
  When the turn opening session starts compacting
  Then the turn opening shows Compacting context without a status message, card or timer
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                        | threshold |
  | desktop  | turn-opening-compacting         | 98        |
  | phone    | turn-opening-compacting         | 98        |

Scenario Outline: Failed opening compaction leaves only the error notice
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent 5 seconds ago
  When the turn opening session starts compacting
  Then the turn opening shows Compacting context without a status message, card or timer
  When the turn opening compaction fails
  Then the opening compaction leaves only its error notice
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                        | threshold |
  | desktop  | turn-opening-compaction-failed  | 98        |
  | phone    | turn-opening-compaction-failed  | 98        |

Scenario Outline: Stopping opening compaction leaves no rule behind
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent 5 seconds ago
  When the turn opening session starts compacting
  Then the turn opening shows Compacting context without a status message, card or timer
  When I stop the turn during its opening compaction
  Then the stopped opening compaction leaves no rule or notice
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                        | threshold |
  | desktop  | turn-opening-compaction-stopped | 98        |
  | phone    | turn-opening-compaction-stopped | 98        |

Scenario: A compacting row before the turn is live never flashes a plain notice
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent 5 seconds ago but the turn is not live
  When I watch for a plain opening compaction notice
  And a compacting row arrives before the turn is live
  Then the turn opening shows Compacting context without a status message, card or timer
  When the turn opening session becomes busy
  Then the turn opening shows Compacting context without a status message, card or timer
  And the plain opening compaction notice never appeared

Scenario: Mid-turn compaction stays a status message
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent 5 seconds ago
  When the first ordinary turn opening step arrives
  Then the turn opening is replaced by a Working card timed 5s
  When the turn opening session starts compacting
  Then the mid-turn compaction is a status message
  And the turn opening is replaced by a Working card timed 5s

Scenario: The live compaction rule stays still under reduced motion
  Given the conduit app is served with the connected mockup
  And reduced motion is enabled for the turn opening
  And the turn opening prompt was sent 5 seconds ago
  When the turn opening session starts compacting
  Then the turn opening shows Compacting context without a status message, card or timer
  And the turn opening has no running animation

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
